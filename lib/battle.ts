import { RNG } from './rng';
import { getBundle } from './data';
import { db, getPlayer, markSeenVirus } from './db';
import { Element } from './types';
import { computeDamage, rollHit } from './damage';
import { tickStart, tickEnd, StatusState } from './effects';
import { detectPA } from './pas';

export type EnemyKind = 'virus' | 'boss';

export interface BattleState {
  id: string;
  user_id: string;

  enemy_kind: EnemyKind;
  enemy_id: string;
  enemy_hp: number;

  player_element: Element | 'Neutral';
  player_hp: number;
  player_hp_max: number;
  navi_atk: number;
  navi_def: number;
  navi_acc: number;
  navi_eva: number;

  turn: number;
  seed: number;
  draw_pile: string[];
  discard_pile: string[];
  hand: string[];
  locked: string[];

  player_status: StatusState;
  enemy_status: StatusState;

  // Boss phases
  phase_index?: number;         // 0-based
  phase_thresholds?: number[];  // parsed from "0.7,0.4"
}

// ---- Storage (SQLite row) ----
const ensureTempTable = () => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS temp_battles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      enemy_kind TEXT NOT NULL,
      enemy_id TEXT NOT NULL,
      enemy_hp INTEGER NOT NULL,
      player_element TEXT NOT NULL,
      player_hp INTEGER NOT NULL,
      player_hp_max INTEGER NOT NULL,
      navi_atk INTEGER NOT NULL,
      navi_def INTEGER NOT NULL,
      navi_acc INTEGER NOT NULL,
      navi_eva INTEGER NOT NULL,
      turn INTEGER NOT NULL,
      seed INTEGER NOT NULL,
      draw_pile TEXT NOT NULL,
      discard_pile TEXT NOT NULL,
      hand TEXT NOT NULL,
      locked TEXT NOT NULL,
      player_status TEXT NOT NULL,
      enemy_status TEXT NOT NULL,
      phase_index INTEGER,
      phase_thresholds TEXT
    );
  `);
};
ensureTempTable();

const Q = {
  put: db.prepare(`
    INSERT OR REPLACE INTO temp_battles
    (id,user_id,enemy_kind,enemy_id,enemy_hp,player_element,player_hp,player_hp_max,navi_atk,navi_def,navi_acc,navi_eva,turn,seed,draw_pile,discard_pile,hand,locked,player_status,enemy_status,phase_index,phase_thresholds)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `),
  get: db.prepare(`SELECT * FROM temp_battles WHERE id=?`),
  del: db.prepare(`DELETE FROM temp_battles WHERE id=?`),
};

// Helper to grab virus/boss row (union)
function enemyMeta(kind: EnemyKind, id: string) {
  const b = getBundle();
  return kind === 'boss' ? b.bosses[id] : b.viruses[id];
}

// ---- Public API ----
export function createBattle(
  userId: string,
  enemyId: string,
  playerElement: Element | 'Neutral',
  enemyKind: EnemyKind = 'virus'
): BattleState {
  const rng = new RNG();
  const id = `b_${userId}_${Date.now()}`;

  const p = getPlayer(userId);
  const stats = {
    hp_max: p?.hp_max ?? 200,
    atk: p?.atk ?? 10,
    def: p?.def ?? 6,
    acc: p?.acc ?? 90,
    eva: p?.evasion ?? 10,
  };

  // Build deck from folder or fallback to first 30 chips
  const { chips } = getBundle();
  const folder = (db.prepare(`SELECT chip_id FROM folder WHERE user_id=? ORDER BY slot`).all(userId) as any[])
    .map(r => r.chip_id)
    .filter(Boolean);
  const fallback = Object.keys(chips).slice(0, 30);
  const deck = (folder.length ? folder : fallback).slice();

  // Shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  const em = enemyMeta(enemyKind, enemyId);
  const enemy_hp = em?.hp ?? 80;

  // Parse boss thresholds like "0.7,0.4" ONLY for bosses
  const thresholds =
    enemyKind === 'boss'
      ? String((em as any)?.phase_thresholds || '')
          .split(',')
          .map(s => parseFloat(s.trim()))
          .filter(n => !isNaN(n) && n > 0 && n < 1)
      : [];

  const s: BattleState = {
    id,
    user_id: userId,
    enemy_kind: enemyKind,
    enemy_id: enemyId,
    enemy_hp,
    player_element: playerElement,
    player_hp: stats.hp_max,
    player_hp_max: stats.hp_max,
    navi_atk: stats.atk,
    navi_def: stats.def,
    navi_acc: stats.acc,
    navi_eva: stats.eva,
    turn: 1,
    seed: rng.seed,
    draw_pile: deck,
    discard_pile: [],
    hand: [],
    locked: [],
    player_status: {},
    enemy_status: {},
    phase_index: 0,
    phase_thresholds: thresholds,
  };

  // Record dex seen
  if (enemyKind === 'virus') markSeenVirus(userId, enemyId);

  drawHand(s, 5);
  save(s);
  return s;
}

export const initBattle = createBattle; // legacy alias

export function load(id: string): BattleState | null {
  const r = Q.get.get(id) as any;
  if (!r) return null;
  return {
    id: r.id,
    user_id: r.user_id,
    enemy_kind: r.enemy_kind,
    enemy_id: r.enemy_id,
    enemy_hp: r.enemy_hp,
    player_element: r.player_element,
    player_hp: r.player_hp,
    player_hp_max: r.player_hp_max,
    navi_atk: r.navi_atk,
    navi_def: r.navi_def,
    navi_acc: r.navi_acc,
    navi_eva: r.navi_eva,
    turn: r.turn,
    seed: r.seed,
    draw_pile: JSON.parse(r.draw_pile),
    discard_pile: JSON.parse(r.discard_pile),
    hand: JSON.parse(r.hand),
    locked: JSON.parse(r.locked),
    player_status: JSON.parse(r.player_status),
    enemy_status: JSON.parse(r.enemy_status),
    phase_index: r.phase_index ?? 0,
    phase_thresholds: r.phase_thresholds ? JSON.parse(r.phase_thresholds) : [],
  } as BattleState;
}

export function save(s: BattleState) {
  Q.put.run(
    s.id, s.user_id, s.enemy_kind, s.enemy_id, s.enemy_hp,
    s.player_element, s.player_hp, s.player_hp_max,
    s.navi_atk, s.navi_def, s.navi_acc, s.navi_eva,
    s.turn, s.seed,
    JSON.stringify(s.draw_pile), JSON.stringify(s.discard_pile),
    JSON.stringify(s.hand), JSON.stringify(s.locked),
    JSON.stringify(s.player_status), JSON.stringify(s.enemy_status),
    s.phase_index ?? 0, JSON.stringify(s.phase_thresholds ?? [])
  );
}

export function end(id: string) { Q.del.run(id); }

// ---- Mechanics ----
export function drawHand(s: BattleState, n = 5) {
  while (s.hand.length < n) {
    if (!s.draw_pile.length) {
      s.draw_pile = s.discard_pile.slice();
      s.discard_pile = [];
      const rng = new RNG(s.seed ^ (s.turn << 1));
      for (let i = s.draw_pile.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [s.draw_pile[i], s.draw_pile[j]] = [s.draw_pile[j], s.draw_pile[i]];
      }
    }
    if (!s.draw_pile.length) break;
    s.hand.push(s.draw_pile.pop()!);
  }
}

export function resolveTurn(
  s: BattleState,
  chosenIds: string[]
): { log: string; enemy_hp: number; player_hp: number; outcome: 'ongoing' | 'victory' | 'defeat' } {
  const em = enemyMeta(s.enemy_kind, s.enemy_id);
  const parts: string[] = [];

  // Start-of-turn status ticks
  const ps = tickStart(s.player_hp, s.player_status);
  s.player_hp = ps.hp; if (ps.notes.length) parts.push(`you: ${ps.notes.join(', ')}`);
  const es = tickStart(s.enemy_hp, s.enemy_status);
  s.enemy_hp = es.hp; if (es.notes.length) parts.push(`enemy: ${es.notes.join(', ')}`);

  // ----- PLAYER ACTION -----
  const { chips } = getBundle();
  let seq = chosenIds.slice();

  // Program Advance collapse (single-turn replacement)
  const paResult = detectPA(seq);
  if (paResult) seq = [paResult];

  let total = 0;
  seq.forEach((id, i) => {
    const c = chips[id]; if (!c) return;
    const ctx = {
      chip_pow: c.power || 0,
      hits: Math.max(1, c.hits || 1),
      navi_atk: s.navi_atk,
      target_def: em?.def ?? 6,
      chip_element: c.element as any,
      navi_element: s.player_element as any,
      crit_chance: 0.06,
      acc: c.acc ?? 0.95,
      navi_acc: s.navi_acc,
      target_evasion: 10,
      def_element: (em?.element as any) ?? 'Neutral',
      rng: () => {
        const x = Math.imul(1664525, (s.seed ^ (s.turn << 8) ^ (i + 1))) + 1013904223;
        return ((x >>> 0) % 1_000_000) / 1_000_000;
      },
    };
    if (!rollHit(ctx)) { parts.push(`${id}: miss`); return; }
    let d = computeDamage(ctx);

    // enemy barrier (MVP)
    if (s.enemy_status.barrier && s.enemy_status.barrier > 0 && d > 0) {
      const absorb = Math.min(s.enemy_status.barrier, d);
      s.enemy_status.barrier! -= absorb; d -= absorb;
      parts.push(`enemy barrier absorbed ${absorb}`);
      if (s.enemy_status.barrier! <= 0) delete s.enemy_status.barrier;
    }

    total += Math.max(0, d);
    parts.push(`${id}${paResult && i === 0 ? ' (PA)' : ''}: ${Math.max(0, d)}`);
  });

  s.enemy_hp = Math.max(0, s.enemy_hp - total);

  // ----- BOSS PHASE SHIFT (narrowed to bosses) -----
  if (s.enemy_kind === 'boss' && (s.phase_thresholds?.length ?? 0) > 0 && em?.hp) {
    const pct = s.enemy_hp / em.hp;
    const nextIdx = s.phase_index ?? 0;
    const trigger = s.phase_thresholds![nextIdx];
    if (trigger !== undefined && pct <= trigger) {
      s.phase_index = nextIdx + 1;
      s.enemy_status.barrier = (s.enemy_status.barrier ?? 0) + 100;
      parts.push(`phase ${s.phase_index} — boss powers up!`);
    }
  }

  if (s.enemy_hp <= 0) {
    tidyAfterTurn(s); save(s);
    return {
      log: parts.join(' • ') || '—',
      enemy_hp: s.enemy_hp,
      player_hp: s.player_hp,
      outcome: 'victory'
    };
  }

  // ----- ENEMY ACTION -----
  if (!(s.enemy_status.freeze) && !(s.enemy_status.paralyze && Math.random() < 0.5)) {
    const basePow = Math.max(10, em?.atk ?? 10) * (s.enemy_kind === 'boss' ? 5 : 4);
    const ctx = {
      chip_pow: basePow,
      hits: 1,
      navi_atk: em?.atk ?? 10,
      target_def: s.navi_def,
      chip_element: (em?.element as any) ?? 'Neutral',
      navi_element: 'Neutral' as const,
      crit_chance: 0.05,
      acc: 0.90,
      navi_acc: 90,
      target_evasion: s.navi_eva,
      def_element: s.player_element as any,
      rng: Math.random,
    };
    if (!rollHit(ctx)) {
      parts.push('enemy: miss');
    } else {
      let dmg = computeDamage(ctx);
      if (s.player_status.barrier && s.player_status.barrier > 0) {
        const absorb = Math.min(s.player_status.barrier, dmg);
        s.player_status.barrier! -= absorb; dmg -= absorb;
        parts.push(`your barrier absorbed ${absorb}`);
        if (s.player_status.barrier! <= 0) delete s.player_status.barrier;
      }
      s.player_hp = Math.max(0, s.player_hp - Math.max(0, dmg));
      parts.push(`enemy: ${Math.max(0, dmg)}`);
    }
  } else {
    parts.push('enemy is stunned');
  }

  // End-of-turn ticks
  tickEnd(s.player_status);
  tickEnd(s.enemy_status);

  s.turn += 1;
  s.discard_pile.push(...s.hand);
  s.hand = [];
  s.locked = [];
  drawHand(s, 5);

  const outcome: 'ongoing' | 'victory' | 'defeat' =
    s.player_hp <= 0 ? 'defeat' : 'ongoing';

  save(s);
  return {
    log: parts.join(' • ') || '—',
    enemy_hp: s.enemy_hp,
    player_hp: s.player_hp,
    outcome
  };
}

function tidyAfterTurn(s: BattleState) {
  s.discard_pile.push(...s.hand);
  s.hand = [];
  s.locked = [];
}

export function tryRun(_s: BattleState): boolean {
  return Math.random() < 0.5;
}
