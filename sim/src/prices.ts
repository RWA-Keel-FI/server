import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { CORR_TO_MARKET, SIGMA_BPS_SQRT_S, TICKERS, type Scenario, type Shock, type Ticker } from './config.ts'
import { Rng } from './rng.ts'
import { getSessionState, nyLocal, nyOffsetSeconds } from './session.ts'

const here = dirname(fileURLToPath(import.meta.url))
export const DATA_DIR = join(here, '..', '..', 'backtest', 'data')

interface Bars {
  ts: number[]
  open: number[]
}

export function loadBars(ticker: string, dir = DATA_DIR): Bars | null {
  const f = join(dir, `px_${ticker}_5m.json`)
  if (!existsSync(f)) return null
  const d = JSON.parse(readFileSync(f, 'utf8')) as { ts: number[]; open: number[] }
  return { ts: d.ts, open: d.open }
}

function lastAtOrBefore(b: Bars, t: number): number {
  let lo = 0
  let hi = b.ts.length - 1
  if (hi < 0 || t < b.ts[0]!) return b.open[0] ?? NaN
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (b.ts[mid]! <= t) lo = mid
    else hi = mid - 1
  }
  return b.open[lo]!
}

/** Latest real bar whose New York weekday and time match the scenario start and whose window stays in one DST regime. */
export function findReplayStart(b: Bars, sc: Scenario): number | null {
  const span = sc.ticks * sc.stepSec
  const endTs = b.ts[b.ts.length - 1]!
  for (let i = b.ts.length - 1; i >= 0; i--) {
    const t = b.ts[i]!
    if (t + span > endTs) continue
    const nl = nyLocal(t)
    if (nl.weekday !== sc.start.weekday) continue
    if (nl.minuteOfDay !== sc.start.hour * 60 + sc.start.minute) continue
    if (nyOffsetSeconds(t) !== nyOffsetSeconds(t + span)) continue
    return t
  }
  return null
}

export interface PricePath {
  /** hidden "true" price of every ticker at each tick, USD */
  prices: Record<Ticker, number>[]
  /** unix seconds of every tick */
  times: number[]
  mode: 'walk' | 'replay'
  note: string
}

export function buildPath(sc: Scenario, startSec: number, startPrices: Record<Ticker, number>, seed: number, shocks: Shock[] = sc.shocks, dataDir = DATA_DIR): PricePath {
  const rng = new Rng(seed)
  const n = sc.ticks
  const times = Array.from({ length: n + 1 }, (_, i) => startSec + i * sc.stepSec)
  const prices: Record<Ticker, number>[] = []
  const cur = { ...startPrices }
  prices.push({ ...cur })

  const spy = loadBars('SPY', dataDir)
  let replayStart: number | null = null
  let note = ''
  const bars: Partial<Record<Ticker, Bars>> = {}
  if (sc.priceMode === 'replay' && spy) {
    replayStart = findReplayStart(spy, sc)
    for (const t of TICKERS) {
      const b = loadBars(t, dataDir)
      if (b) bars[t] = b
    }
  }
  const mode: 'walk' | 'replay' = replayStart != null ? 'replay' : 'walk'
  if (sc.priceMode === 'replay' && replayStart == null) note = 'replay bars not found, fell back to a random walk. '
  if (mode === 'replay') note = `replay of real 5-minute bars from ${new Date(replayStart! * 1000).toISOString()}; tickers without bars use a beta-to-SPY walk. `

  const sigmaSpy = SIGMA_BPS_SQRT_S.SPY * 1e-4
  const applied = new Set<number>()
  for (let i = 1; i <= n; i++) {
    const t = times[i]!
    const open = getSessionState(t, 'extended').open
    const volF = (open ? 1 : sc.closedVolFactor) * sc.volScale
    const z = rng.normal() // common market factor, standard normal
    const next = {} as Record<Ticker, number>
    for (const tk of TICKERS) {
      const b = bars[tk]
      if (mode === 'replay' && b) {
        const real0 = lastAtOrBefore(b, replayStart!)
        const realT = lastAtOrBefore(b, replayStart! + (t - startSec))
        next[tk] = startPrices[tk] * (realT / real0)
        continue
      }
      const sig = SIGMA_BPS_SQRT_S[tk] * 1e-4 * Math.sqrt(sc.stepSec)
      const rho = tk === 'SPY' ? 1 : CORR_TO_MARKET
      let zm = z
      let idioF = volF
      if (mode === 'replay' && bars.SPY) {
        // the market factor is SPY's real return over this step, in standard deviations
        const prevT = times[i - 1]!
        const r = lastAtOrBefore(bars.SPY, replayStart! + (t - startSec)) / lastAtOrBefore(bars.SPY, replayStart! + (prevT - startSec)) - 1
        zm = Math.max(-6, Math.min(6, r / (sigmaSpy * Math.sqrt(sc.stepSec))))
        idioF = open ? 1 : sc.closedVolFactor
      }
      const ret = sig * (rho * zm * (mode === 'replay' ? 1 : volF) + Math.sqrt(1 - rho * rho) * rng.normal() * idioF)
      next[tk] = cur[tk] * (1 + ret)
    }
    // news shocks (hidden true-price jumps, applied once)
    shocks.forEach((s, k) => {
      if (!applied.has(k) && t - startSec >= s.atSec) {
        applied.add(k)
        next[s.ticker] *= 1 + s.pct / 100
      }
    })
    for (const tk of TICKERS) cur[tk] = next[tk]
    prices.push({ ...next })
  }
  return { prices, times, mode, note: note.trim() }
}
