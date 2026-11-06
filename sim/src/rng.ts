/** Small seeded RNG so every scenario run is reproducible. */
export class Rng {
  private a: number
  constructor(seed: number) {
    this.a = seed >>> 0
  }
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0
    let t = this.a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  normal(): number {
    const u = Math.max(this.next(), 1e-12)
    const v = this.next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  poisson(lambda: number): number {
    if (lambda <= 0) return 0
    const l = Math.exp(-lambda)
    let k = 0
    let p = 1
    do {
      k++
      p *= this.next()
    } while (p > l && k < 1000)
    return k - 1
  }
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal())
  }
  bool(p = 0.5): boolean {
    return this.next() < p
  }
}
