import { join } from 'node:path'
import { ArbBot, Feeder, RetailBot, type TickCtx } from './bots.ts'
import { TICKERS, type Scenario, type Shock, type SimParams, type Ticker } from './config.ts'
import { LpWatch } from './lpwatch.ts'
import { buildPath } from './prices.ts'
import { Rng } from './rng.ts'
import { getSessionState, nextNyStart } from './session.ts'
import type { Venue } from './venue.ts'

export interface RunOptions {
  scenario: Scenario
  venue: Venue
  params: SimParams
  seed: number
  outDir: string
  shocks?: Shock[]
  log?: (s: string) => void
}

export async function runScenario(o: RunOptions): Promise<Record<string, unknown>> {
  const log = o.log ?? (() => {})
  const sc = o.scenario
  const venue = o.venue
  await venue.init()

  const startPrices = {} as Record<Ticker, number>
  for (const tk of TICKERS) startPrices[tk] = venue.startPriceUsd(tk)

  const chainNow = await venue.nowSec()
  const startSec = nextNyStart(Math.max(chainNow, Math.floor(Date.now() / 1000)) + 120, sc.start.weekday, sc.start.hour, sc.start.minute)
  const path = buildPath(sc, startSec, startPrices, o.seed, o.shocks ?? sc.shocks)
  log(`scenario ${sc.name}: ${sc.ticks} ticks x ${sc.stepSec}s from ${new Date(startSec * 1000).toISOString()} (${path.mode}) ${path.note}`)

  const rng = new Rng(o.seed ^ 0x9e3779b9)
  const watch = new LpWatch(o.outDir, venue.pools())
  const feeder = new Feeder(venue, sc, o.params, rng)
  const arb = new ArbBot(venue, sc, o.params, watch)
  const retail = new RetailBot(venue, sc, rng, watch)

  let lastTrue = path.prices[0]!
  let clockSlips = 0
  for (let i = 0; i < sc.ticks; i++) {
    const planned = path.times[i]!
    const t = await venue.setTime(planned)
    if (t > planned) clockSlips++
    const session = getSessionState(t, 'extended')
    const trueP = path.prices[i]!
    lastTrue = trueP
    const ctx: TickCtx = { tick: i, t, session, trueP }

    await feeder.step(ctx)
    await arb.step(ctx)
    await retail.step(ctx)

    const oracle: Record<string, number> = {}
    for (const tk of TICKERS) {
      const v = await venue.oracle(tk)
      if (v.priceUsd > 0 && v.sessionOpen && t - v.asOf <= o.params.maxAge) oracle[tk] = v.priceUsd
    }
    const pools = []
    for (const pool of venue.pools()) pools.push({ pool, price: (await venue.poolState(pool)).priceUsd })
    watch.snapshot(i, t, session.phase, trueP, oracle, pools)
    if (i % 20 === 0 || i === sc.ticks - 1) log(`  tick ${i + 1}/${sc.ticks} ${new Date(t * 1000).toISOString().slice(0, 16)} ${session.phase}`)
  }

  const summary = watch.summary({
    scenario: sc.name,
    description: sc.description,
    venue: venue.kind,
    ticks: sc.ticks,
    stepSec: sc.stepSec,
    seed: o.seed,
    simStart: new Date(startSec * 1000).toISOString(),
    simEnd: new Date((path.times[sc.ticks - 1] ?? startSec) * 1000).toISOString(),
    priceMode: path.mode,
    priceNote: path.note,
    f0Pips: venue.f0Pips(),
    params: o.params,
    oracleReportsPushed: feeder.pushed,
    closedHeartbeats: feeder.heartbeats,
    clockSlips,
    finalTruePrices: Object.fromEntries(TICKERS.map((tk) => [tk, Math.round(lastTrue[tk] * 100) / 100])),
    caveats: [
      'Mock tokens and mock USDC; the arbitrageur and retail users are simulated bots.',
      venue.kind === 'model'
        ? 'MODEL venue: an in-memory constant-product pool applying the hook fee rule in floating point. It is not the on-chain hook.'
        : 'ANVIL venue: swaps go through the deployed v4 pools and the deployed hook on a local anvil chain.',
      'lpPnl is LP profit versus holding the starting inventory, valued at the hidden true price, fees included. Each pool has one liquidity position, so pool P&L equals LP P&L.',
      'arbProfit is gross of gas; arbProfitNetOfGas subtracts a modeled per-swap gas cost.',
    ],
  })
  await venue.close()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(o.outDir, `summary-${sc.name}.json`), JSON.stringify(summary, null, 2) + '\n')
  return summary
}
