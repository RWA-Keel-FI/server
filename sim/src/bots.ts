import { SIGMA_BPS_SQRT_S, TICKERS, type Scenario, type SimParams, type Ticker } from './config.ts'
import { planArb } from './cpmath.ts'
import type { LpWatch } from './lpwatch.ts'
import type { Rng } from './rng.ts'
import type { SessionState } from './session.ts'
import type { Actor, PoolRef, Side, Venue } from './venue.ts'

export interface TickCtx {
  tick: number
  t: number
  session: SessionState
  trueP: Record<Ticker, number>
}

/** Plays the part of the CRE workflow: pushes the stock price while the US session is open, heartbeats while closed. */
export class Feeder {
  private lastPush = -Infinity
  private lastHb = -Infinity
  pushed = 0
  heartbeats = 0
  constructor(private venue: Venue, private sc: Scenario, private params: SimParams, private rng: Rng, private closedHeartbeatSec = 1800) {}

  async step(c: TickCtx): Promise<void> {
    if (c.session.open) {
      if (c.t - this.lastPush < this.sc.refreshSec) return
      this.lastPush = c.t
      for (const tk of TICKERS) {
        const noise = (this.rng.normal() * this.params.quoteNoiseBps) / 1e4
        await this.venue.pushReport(tk, c.trueP[tk] * (1 + noise), true, c.t)
        this.pushed++
      }
    } else if (c.t - this.lastHb >= this.closedHeartbeatSec) {
      this.lastHb = c.t
      for (const tk of TICKERS) {
        await this.venue.pushReport(tk, 0, false, c.t)
        this.heartbeats++
      }
    }
  }
}

/** Trades both pools of every ticker toward the oracle reference when the edge beats fee plus modeled gas. */
export class ArbBot {
  constructor(private venue: Venue, private sc: Scenario, private params: SimParams, private watch: LpWatch) {}

  async step(c: TickCtx): Promise<void> {
    for (const pool of this.venue.pools()) {
      const o = await this.venue.oracle(pool.ticker)
      const fresh = o.priceUsd > 0 && o.sessionOpen && c.t - o.asOf <= this.params.maxAge
      let r: number
      let actor: Actor
      if (fresh) {
        r = o.priceUsd
        actor = 'arb'
      } else if (this.sc.informedWeekend && !c.session.open) {
        r = c.trueP[pool.ticker] // hidden news the arb knows and the oracle does not
        actor = 'informed'
      } else continue
      await this.work(pool, r, actor, c)
    }
  }

  private async work(pool: PoolRef, r: number, actor: Actor, c: TickCtx): Promise<void> {
    for (let i = 0; i < this.params.arbMaxIter; i++) {
      const st = await this.venue.poolState(pool)
      const side: Side = st.priceUsd > r ? 'sellStock' : 'buyStock'
      const q = await this.venue.quote(pool, side)
      const plan = planArb(st.L, st.priceUsd, r, q.feePips / 1e6, this.params.arbMaxMove)
      if (!plan || plan.profit < this.params.arbGasUsd) return
      let size = plan.grossIn / this.params.arbChunks
      const usd = side === 'sellStock' ? size * st.priceUsd : size
      if (usd > this.params.arbMaxUsd) size *= this.params.arbMaxUsd / usd
      const fill = await this.venue.swap(pool, actor, side, size)
      this.watch.record({ tick: c.tick, t: c.t, pool, actor, side, fill, refPrice: r, gasUsd: this.params.arbGasUsd })
      if (!fill.ok) return
    }
  }
}

/** Ordinary users: the same random order goes to the hook pool and the control pool, so fees are directly comparable. */
export class RetailBot {
  constructor(private venue: Venue, private sc: Scenario, private rng: Rng, private watch: LpWatch) {}

  async step(c: TickCtx): Promise<void> {
    const perHour = c.session.open ? this.sc.retailPerHourOpen : this.sc.retailPerHourClosed
    const lambda = (perHour * this.sc.stepSec) / 3600
    for (const tk of TICKERS) {
      const n = this.rng.poisson(lambda)
      for (let k = 0; k < n; k++) {
        const side: Side = this.rng.bool() ? 'sellStock' : 'buyStock'
        const usd = Math.min(5000, Math.max(20, this.rng.lognormal(this.sc.retailMedianUsd, 0.8)))
        const px = c.trueP[tk]
        const amountIn = side === 'sellStock' ? usd / px : usd
        const order: PoolRef[] = this.venue.pools().filter((p) => p.ticker === tk)
        if (this.rng.bool()) order.reverse()
        for (const pool of order) {
          const fill = await this.venue.swap(pool, 'retail', side, amountIn)
          this.watch.record({ tick: c.tick, t: c.t, pool, actor: 'retail', side, fill, refPrice: px, gasUsd: 0 })
        }
      }
    }
  }
}

export const sigmaFrac = (t: Ticker) => SIGMA_BPS_SQRT_S[t] * 1e-4
