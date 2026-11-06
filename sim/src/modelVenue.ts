import { SIGMA_BPS_SQRT_S, TICKERS, FALLBACK_START_USD, type SimParams, type Ticker } from './config.ts'
import { hookFee, isArbDirection } from './fee.ts'
import type { Actor, OracleView, PoolRef, PoolState, Side, SwapFill, Venue } from './venue.ts'

interface MPool {
  ref: PoolRef
  x: number
  y: number
}

/**
 * In-memory constant-product venue that applies the hook's fee rule in floating point.
 * It is NOT the on-chain hook: it exists so the bots and accounting can be exercised without a chain,
 * and as a cross-check for the anvil run.
 */
export class ModelVenue implements Venue {
  kind = 'model' as const
  private pools_: MPool[] = []
  private feeds = new Map<Ticker, OracleView>()
  private t = Math.floor(Date.now() / 1000)
  private f0 = 0.003
  private start: Record<Ticker, number>

  constructor(
    private params: SimParams,
    startPrices?: Partial<Record<Ticker, number>>,
    f0Pips = 3000,
  ) {
    this.f0 = f0Pips / 1e6
    this.start = { ...FALLBACK_START_USD, ...startPrices }
  }

  async init(): Promise<void> {
    for (const tk of TICKERS) {
      for (const kind of ['hook', 'control'] as const) {
        const y = this.params.modelTvlUsd / 2
        this.pools_.push({ ref: { ticker: tk, kind, id: `${tk}-${kind}` }, x: y / this.start[tk], y })
      }
    }
  }
  tickers(): Ticker[] {
    return [...TICKERS]
  }
  startPriceUsd(t: Ticker): number {
    return this.start[t]
  }
  pools(): PoolRef[] {
    return this.pools_.map((p) => p.ref)
  }
  f0Pips(): number {
    return Math.round(this.f0 * 1e6)
  }
  async nowSec(): Promise<number> {
    return this.t
  }
  async setTime(t: number): Promise<number> {
    this.t = Math.max(t, this.t)
    return this.t
  }
  private get(p: PoolRef): MPool {
    const m = this.pools_.find((q) => q.ref.id === p.id)
    if (!m) throw new Error(`unknown pool ${p.id}`)
    return m
  }
  async poolState(p: PoolRef): Promise<PoolState> {
    const m = this.get(p)
    return { priceUsd: m.y / m.x, L: Math.sqrt(m.x * m.y) }
  }
  async oracle(t: Ticker): Promise<OracleView> {
    return this.feeds.get(t) ?? { priceUsd: 0, asOf: 0, sessionOpen: false }
  }
  async pushReport(t: Ticker, priceUsd: number, sessionOpen: boolean, asOf: number): Promise<void> {
    if (priceUsd <= 0) return // the real oracle ignores zero-price heartbeats
    const cur = this.feeds.get(t)
    if (asOf > this.t + 60) return
    if (cur && asOf <= cur.asOf) return
    this.feeds.set(t, { priceUsd, asOf, sessionOpen })
  }
  private feeFor(m: MPool, side: Side) {
    const price = m.y / m.x
    if (m.ref.kind === 'control') return { fee: this.f0, armed: false, arb: false }
    const o = this.feeds.get(m.ref.ticker)
    const r = hookFee(
      { f0: this.f0, feeMax: this.params.feeMax, sigma: SIGMA_BPS_SQRT_S[m.ref.ticker] * 1e-4, maxAge: this.params.maxAge },
      price,
      o?.priceUsd ?? 0,
      o ? this.t - o.asOf : 1e9,
      o?.sessionOpen ?? false,
      side,
    )
    return { fee: r.fee, armed: r.armed, arb: o ? isArbDirection(price, o.priceUsd, side) : false }
  }
  async quote(p: PoolRef, side: Side) {
    const f = this.feeFor(this.get(p), side)
    return { feePips: Math.round(f.fee * 1e6), arbDirection: f.arb }
  }
  async swap(p: PoolRef, _actor: Actor, side: Side, amountIn: number): Promise<SwapFill> {
    const m = this.get(p)
    const { fee } = this.feeFor(m, side)
    const net = amountIn * (1 - fee)
    const k = m.x * m.y
    let usdDelta: number
    let stockDelta: number
    let feeUsd: number
    let volumeUsd: number
    if (side === 'sellStock') {
      const out = (m.y * net) / (m.x + net)
      m.x += net
      m.y -= out
      stockDelta = amountIn
      usdDelta = -out
      const px = m.y / m.x
      feeUsd = amountIn * fee * px
      volumeUsd = out
    } else {
      const out = (m.x * net) / (m.y + net)
      m.y += net
      m.x -= out
      usdDelta = amountIn
      stockDelta = -out
      feeUsd = amountIn * fee
      volumeUsd = amountIn
    }
    void k
    return { ok: true, feePips: Math.round(fee * 1e6), f0Pips: this.f0Pips(), usdDelta, stockDelta, feeUsd, volumeUsd, priceAfter: m.y / m.x }
  }
  async close(): Promise<void> {}
}
