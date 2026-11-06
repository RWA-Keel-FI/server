export const TICKERS = ['NVDA', 'TSLA', 'SPY', 'META', 'GOOGL', 'AAPL'] as const
export type Ticker = (typeof TICKERS)[number]

/** Correlation of every synthetic stock with the market factor (SPY). Total volatility of each stock stays at SIGMA_BPS_SQRT_S. */
export const CORR_TO_MARKET = 0.6

/** Volatility, bps per root second. NVDA/TSLA/SPY measured in backtest/RESULTS.md; the rest are assumptions. */
export const SIGMA_BPS_SQRT_S: Record<Ticker, number> = { NVDA: 0.85, TSLA: 1.33, SPY: 0.86, META: 1.0, GOOGL: 0.9, AAPL: 0.8 }

/** Used only when the deployment gives no startPriceE8. Rough 2026 levels. */
export const FALLBACK_START_USD: Record<Ticker, number> = { NVDA: 187, TSLA: 354, SPY: 781, META: 640, GOOGL: 285, AAPL: 265 }

export interface Shock {
  /** seconds after the simulation start */
  atSec: number
  ticker: Ticker
  /** +3 means +3% */
  pct: number
}

export interface Scenario {
  name: string
  description: string
  /** first tick, New York local time; weekday 0 = Sunday */
  start: { weekday: number; hour: number; minute: number }
  ticks: number
  stepSec: number
  priceMode: 'walk' | 'replay'
  /** multiplies sigma in walk mode */
  volScale: number
  /** price volatility factor while the US session is closed */
  closedVolFactor: number
  shocks: Shock[]
  /** retail orders per ticker per hour while the US session is open / closed */
  retailPerHourOpen: number
  retailPerHourClosed: number
  retailMedianUsd: number
  /** oracle refresh period, seconds (CRE cron) */
  refreshSec: number
  /** when true the arb bot also trades toward the hidden true price while the session is closed */
  informedWeekend: boolean
}

export const SCENARIOS: Record<string, Scenario> = {
  calm: {
    name: 'calm',
    description: 'Tuesday 10:00 NY, four hours of ordinary trading, low volatility, random-walk prices.',
    start: { weekday: 2, hour: 10, minute: 0 },
    ticks: 240,
    stepSec: 60,
    priceMode: 'walk',
    volScale: 1,
    closedVolFactor: 0.1,
    shocks: [],
    retailPerHourOpen: 30,
    retailPerHourClosed: 4,
    retailMedianUsd: 300,
    refreshSec: 60,
    informedWeekend: false,
  },
  volatile: {
    name: 'volatile',
    description: 'Tuesday 10:00 NY, four hours at 3x volatility with two news jumps.',
    start: { weekday: 2, hour: 10, minute: 0 },
    ticks: 240,
    stepSec: 60,
    priceMode: 'walk',
    volScale: 3,
    closedVolFactor: 0.1,
    shocks: [
      { atSec: 3600, ticker: 'NVDA', pct: 2.5 },
      { atSec: 9000, ticker: 'TSLA', pct: -3 },
    ],
    retailPerHourOpen: 30,
    retailPerHourClosed: 4,
    retailMedianUsd: 300,
    refreshSec: 60,
    informedWeekend: false,
  },
  'weekend-gap': {
    name: 'weekend-gap',
    description:
      'Friday 19:30 NY to Monday 13:00 NY, 15-minute steps, real replay bars (the gap at Monday pre-market is real data). Session closes Friday 20:00, the oracle goes quiet, then resumes Monday 04:00.',
    start: { weekday: 5, hour: 19, minute: 30 },
    ticks: 262,
    stepSec: 900,
    priceMode: 'replay',
    volScale: 1,
    closedVolFactor: 0.1,
    shocks: [],
    retailPerHourOpen: 30,
    retailPerHourClosed: 3,
    retailMedianUsd: 300,
    refreshSec: 900,
    informedWeekend: true,
  },
}

export interface SimParams {
  /** total value locked per pool in the in-memory model, USD */
  modelTvlUsd: number
  /** modeled gas cost per arb swap, USD */
  arbGasUsd: number
  /** the arb splits each full-boundary trade into this many pieces (1 = greedy) */
  arbChunks: number
  /** max swaps the arb sends into one pool per tick */
  arbMaxIter: number
  /** one arb swap moves the pool price by at most this fraction (keeps swaps inside the LP ranges) */
  arbMaxMove: number
  /** cap on one arb swap, USD */
  arbMaxUsd: number
  /** fee ceiling, fraction (matches the hook's default 2%) */
  feeMax: number
  /** oracle staleness limit, seconds (matches the hook's default 900) */
  maxAge: number
  /** relative noise on the oracle quote, bps */
  quoteNoiseBps: number
}

export const DEFAULT_PARAMS: SimParams = {
  modelTvlUsd: 400_000,
  arbGasUsd: 0.5,
  arbChunks: 1,
  arbMaxIter: 24,
  arbMaxMove: 0.01,
  arbMaxUsd: 150_000,
  feeMax: 0.02,
  maxAge: 900,
  quoteNoiseBps: 0.5,
}
