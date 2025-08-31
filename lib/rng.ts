export class RNG {
  seed: number;
  constructor(seed?: number) { this.seed = (seed ?? Date.now()) >>> 0; }
  next(): number {
    // LCG
    this.seed = (Math.imul(1664525, this.seed) + 1013904223) >>> 0;
    return (this.seed >>> 0) / 0x100000000;
  }
  int(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick<T>(arr: T[]): T { return arr[this.int(0, arr.length - 1)]; }
  chance(p: number): boolean { return this.next() < p; }
}
