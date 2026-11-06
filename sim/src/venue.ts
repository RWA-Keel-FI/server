import type { Ticker } from './config.ts'

export type Side = 'sellStock' | 'buyStock'
export type Actor = 'arb' | 'informed' | 'retail'

export interface PoolRef {
  ticker: Ticker
  kind: 'hook' | 'control'
  id: string
}

export interface PoolState {
  priceUsd: number
  /** sqrt(stock * usd) in human units, the in-range liquidity */
  L: number
}

export interface OracleView {
  priceUsd: number
  asOf: number
  sessionOpen: boolean
}

export interface SwapFill {
  ok: boolean
  error?: string
  feePips: number
  f0Pips: number
  /** from the pool's point of view: positive = the pool received it */
  usdDelta: number
  stockDelta: number
  feeUsd: number
  volumeUsd: number
  priceAfter: number
  txHash?: string
}

export interface Venue {
  kind: 'model' | 'anvil'
  init(): Promise<void>
  tickers(): Ticker[]
  startPriceUsd(t: Ticker): number
  pools(): PoolRef[]
  /** latest chain time in seconds */
  nowSec(): Promise<number>
  /** sets the next block timestamp, returns the time actually used (monotonic) */
  setTime(t: number): Promise<number>
  poolState(p: PoolRef): Promise<PoolState>
  oracle(t: Ticker): Promise<OracleView>
  /** priceUsd = 0 is a closed-session heartbeat, which the oracle ignores */
  pushReport(t: Ticker, priceUsd: number, sessionOpen: boolean, asOf: number): Promise<void>
  /** fee the hook will charge the next swap in this direction, pips */
  quote(p: PoolRef, side: Side): Promise<{ feePips: number; arbDirection: boolean }>
  /** amountIn is in human units of the input token (stock for sellStock, USD for buyStock) */
  swap(p: PoolRef, actor: Actor, side: Side, amountIn: number): Promise<SwapFill>
  f0Pips(): number
  close(): Promise<void>
}
