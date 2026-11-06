import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ticker } from './config.ts'
import type { Actor, PoolRef, Side, SwapFill } from './venue.ts'

export interface SwapRec {
  tick: number
  t: number
  pool: PoolRef
  actor: Actor
  side: Side
  fill: SwapFill
  /** price the actor valued the trade at (oracle ref for arb, hidden true price for informed and retail) */
  refPrice: number
  /** modeled gas, USD (arb and informed only) */
  gasUsd: number
}

interface Acc {
  swaps: number
  swapsSurcharged: number
  volume: number
  arbVolume: number
  retailVolume: number
  fees: number
  arbProfitGross: number
  arbProfitNet: number
  retailFeePaid: number
  retailSwaps: number
  retailSurcharged: number
  arbSwaps: number
  arbSurcharged: number
  failed: number
  cumUsd: number
  cumStock: number
}

const blank = (): Acc => ({
  swaps: 0, swapsSurcharged: 0, volume: 0, arbVolume: 0, retailVolume: 0, fees: 0, arbProfitGross: 0, arbProfitNet: 0,
  retailFeePaid: 0, retailSwaps: 0, retailSurcharged: 0, arbSwaps: 0, arbSurcharged: 0, failed: 0, cumUsd: 0, cumStock: 0,
})

const key = (p: PoolRef) => `${p.ticker}/${p.kind}`
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0)
const r2 = (x: number) => Math.round(x * 100) / 100

export class LpWatch {
  private acc = new Map<string, Acc>()
  private lastMarks: Partial<Record<Ticker, number>> = {}
  private metricsPath: string
  constructor(private outDir: string, pools: PoolRef[]) {
    mkdirSync(outDir, { recursive: true })
    this.metricsPath = join(outDir, 'metrics.jsonl')
    writeFileSync(this.metricsPath, '')
    for (const p of pools) this.acc.set(key(p), blank())
  }

  record(r: SwapRec): void {
    const a = this.acc.get(key(r.pool))!
    if (!r.fill.ok) {
      a.failed++
      return
    }
    const f = r.fill
    const surcharged = f.feePips > f.f0Pips
    a.swaps++
    if (surcharged) a.swapsSurcharged++
    a.volume += f.volumeUsd
    a.fees += f.feeUsd
    a.cumUsd += f.usdDelta
    a.cumStock += f.stockDelta
    if (r.actor === 'retail') {
      a.retailVolume += f.volumeUsd
      a.retailFeePaid += f.feeUsd
      a.retailSwaps++
      if (surcharged) a.retailSurcharged++
    } else {
      // pool perspective: the actor's gain is the pool's loss, valued at the actor's reference price
      const gross = -(f.usdDelta + f.stockDelta * r.refPrice)
      a.arbVolume += f.volumeUsd
      a.arbProfitGross += gross
      a.arbProfitNet += gross - r.gasUsd
      a.arbSwaps++
      if (surcharged) a.arbSurcharged++
    }
  }

  /** LP profit and loss against simply holding the starting inventory, valued at `mark`. Fees are included. */
  lpPnl(p: PoolRef, mark: number): number {
    const a = this.acc.get(key(p))!
    return a.cumUsd + a.cumStock * mark
  }

  snapshot(tick: number, t: number, sessionPhase: string, trueP: Record<Ticker, number>, oracle: Record<string, number>, pools: { pool: PoolRef; price: number }[]): void {
    this.lastMarks = { ...trueP }
    const out: Record<string, unknown> = {}
    for (const { pool, price } of pools) {
      const a = this.acc.get(key(pool))!
      const ref = oracle[pool.ticker] || trueP[pool.ticker]
      out[key(pool)] = {
        price: r2(price),
        devBps: r2((price / ref - 1) * 1e4),
        lpPnl: r2(this.lpPnl(pool, trueP[pool.ticker])),
        fees: r2(a.fees),
        volume: r2(a.volume),
      }
    }
    appendFileSync(this.metricsPath, JSON.stringify({ tick, t, iso: new Date(t * 1000).toISOString(), session: sessionPhase, trueP: Object.fromEntries(Object.entries(trueP).map(([k, v]) => [k, r2(v)])), pools: out }) + '\n')
  }

  summary(meta: Record<string, unknown>): Record<string, unknown> {
    const perTicker: Record<string, unknown> = {}
    const tot = { hook: blank(), control: blank() } as Record<'hook' | 'control', Acc & { lpPnl: number }>
    tot.hook = { ...blank(), lpPnl: 0 }
    tot.control = { ...blank(), lpPnl: 0 }
    const tickers = [...new Set([...this.acc.keys()].map((k) => k.split('/')[0] as Ticker))]
    for (const tk of tickers) {
      const row: Record<string, unknown> = {}
      for (const kind of ['hook', 'control'] as const) {
        const p: PoolRef = { ticker: tk, kind, id: `${tk}-${kind}` }
        const a = this.acc.get(key(p))!
        const pnl = this.lpPnl(p, this.lastMarks[tk] ?? 0)
        const t = tot[kind]
        for (const f of Object.keys(a) as (keyof Acc)[]) t[f] += a[f]
        t.lpPnl += pnl
        row[kind] = {
          volume: r2(a.volume),
          arbVolume: r2(a.arbVolume),
          retailVolume: r2(a.retailVolume),
          fees: r2(a.fees),
          arbProfit: r2(a.arbProfitGross),
          arbProfitNetOfGas: r2(a.arbProfitNet),
          retailFeePaid: r2(a.retailFeePaid),
          retailAvgFeeBps: r2(a.retailVolume > 0 ? (a.retailFeePaid / a.retailVolume) * 1e4 : 0),
          lpPnl: r2(pnl),
          lpPnlExFees: r2(pnl - a.fees),
          swaps: a.swaps,
          swapsSurchargedPct: r2(pct(a.swapsSurcharged, a.swaps)),
          retailSwaps: a.retailSwaps,
          retailSurchargedPct: r2(pct(a.retailSurcharged, a.retailSwaps)),
          arbSwaps: a.arbSwaps,
          arbSurchargedPct: r2(pct(a.arbSurcharged, a.arbSwaps)),
          failedSwaps: a.failed,
        }
      }
      const h = row.hook as { lpPnl: number; retailFeePaid: number; arbProfit: number }
      const c = row.control as { lpPnl: number; retailFeePaid: number; arbProfit: number }
      row.hookMinusControl = { lpPnl: r2(h.lpPnl - c.lpPnl), retailFeePaid: r2(h.retailFeePaid - c.retailFeePaid), arbProfit: r2(h.arbProfit - c.arbProfit) }
      perTicker[tk] = row
    }
    const totals = (a: Acc & { lpPnl: number }) => ({
      volume: r2(a.volume), fees: r2(a.fees), arbProfit: r2(a.arbProfitGross), arbProfitNetOfGas: r2(a.arbProfitNet),
      retailVolume: r2(a.retailVolume), retailFeePaid: r2(a.retailFeePaid),
      retailAvgFeeBps: r2(a.retailVolume > 0 ? (a.retailFeePaid / a.retailVolume) * 1e4 : 0),
      lpPnl: r2(a.lpPnl), lpPnlExFees: r2(a.lpPnl - a.fees), swaps: a.swaps, swapsSurchargedPct: r2(pct(a.swapsSurcharged, a.swaps)),
      retailSwaps: a.retailSwaps, retailSurchargedPct: r2(pct(a.retailSurcharged, a.retailSwaps)),
      arbSwaps: a.arbSwaps, arbSurchargedPct: r2(pct(a.arbSurcharged, a.arbSwaps)), failedSwaps: a.failed,
    })
    const out = {
      ...meta,
      perTicker,
      totals: {
        hook: totals(tot.hook),
        control: totals(tot.control),
        hookMinusControl: {
          lpPnl: r2(tot.hook.lpPnl - tot.control.lpPnl),
          retailFeePaid: r2(tot.hook.retailFeePaid - tot.control.retailFeePaid),
          arbProfit: r2(tot.hook.arbProfitGross - tot.control.arbProfitGross),
        },
      },
    }
    writeFileSync(join(this.outDir, 'summary.json'), JSON.stringify(out, null, 2) + '\n')
    return out
  }
}
