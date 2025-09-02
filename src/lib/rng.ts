// src/lib/rng.ts
export class RNG {
  // Public so other modules (e.g., battle.ts) can read it for logs/debug.
  public seed: number;

  // Simple 32-bit LCG (Numerical Recipes parameters)
  private static readonly A = 1664525;
  private static readonly C = 1013904223;
  private static readonly M = 0x100000000; // 2^32

  constructor(seed?: number) {
    // If no seed is provided, derive one from time + a little entropy.
    const s = Number(seed);
    this.seed = Number.isFinite(s) ? (s >>> 0) : ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
  }

  /** Advance the generator one step and return the new 32-bit state. */
  private next(): number {
    this.seed = (Math.imul(RNG.A, this.seed) + RNG.C) >>> 0;
    return this.seed;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    // Divide by 2^32 to map to [0,1)
    return this.next() / RNG.M;
  }

  /** Integer in [lo, hi] (inclusive). If only hi provided, range is [0, hi]. */
  int(lo: number, hi?: number): number {
    let a = 0, b = 0;
    if (typeof hi === 'number') { a = Math.floor(lo); b = Math.floor(hi); }
    else { a = 0; b = Math.floor(lo); }
    if (b < a) [a, b] = [b, a];
    const span = (b - a + 1);
    return a + Math.floor(this.float() * span);
  }

  /** Pick one element from a non-empty array. */
  pick<T>(arr: T[]): T {
    if (!arr.length) throw new Error('RNG.pick called with empty array');
    return arr[this.int(arr.length - 1)];
  }

  /** True with probability p (0..1). */
  chance(p: number): boolean {
    return this.float() < Math.max(0, Math.min(1, p));
  }
}
