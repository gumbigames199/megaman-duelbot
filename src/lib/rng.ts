// src/lib/rng.ts

/**
 * Tiny RNG with a deterministic LCG core (when seeded) and a Math.random()
 * fallback (when no seed provided). Exposes `float()` as used by rewards.ts.
 */
export class RNG {
  private seeded = false;
  private state = 0;

  // LCG constants from Numerical Recipes (mod 2^32)
  private static readonly A = 1664525;
  private static readonly C = 1013904223;
  private static readonly M = 0x100000000; // 2^32

  constructor(seed?: number) {
    if (typeof seed === 'number' && Number.isFinite(seed)) {
      this.seeded = true;
      // ensure uint32
      this.state = (seed >>> 0);
      if (this.state === 0) this.state = 1; // avoid trivial zero cycle
    }
  }

  /** 0 ≤ x < 1 */
  float(): number {
    if (!this.seeded) return Math.random();
    this.state = (RNG.A * this.state + RNG.C) >>> 0;
    // map uint32 to [0,1)
    return (this.state % RNG.M) / RNG.M;
  }

  /** integer in [lo, hi] inclusive */
  int(lo: number, hi: number): number {
    const a = Math.floor(lo);
    const b = Math.floor(hi);
    if (b < a) return this.int(b, a);
    return a + Math.floor(this.float() * (b - a + 1));
  }

  /** pick a random element from an array (throws if empty) */
  pick<T>(arr: T[]): T {
    if (!arr.length) throw new Error('RNG.pick: empty array');
    return arr[this.int(0, arr.length - 1)];
  }
}
