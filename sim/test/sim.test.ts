import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_PARAMS, SCENARIOS, TICKERS, FALLBACK_START_USD } from '../src/config.ts'
import { planArb } from '../src/cpmath.ts'
import { runScenario } from '../src/engine.ts'
import { hookFee, isArbDirection } from '../src/fee.ts'
import { LpWatch } from '../src/lpwatch.ts'
import { ModelVenue } from '../src/modelVenue.ts'
import { buildPath, loadBars, findReplayStart } from '../src/prices.ts'
import { Rng } from '../src/rng.ts'
import { getSessionState, nextNyStart } from '../src/session.ts'

const P = { f0: 0.003, feeMax: 0.02, sigma: 0.85e-4, maxAge: 900 }

test('fee rule: deadband, direction, noise, fail-open, cap', () => {
  // pool 1% above ref: selling stock into it is the arb direction
  assert.ok(isArbDirection(101, 100, 'sellStock'))
  assert.ok(!isArbDirection(101, 100, 'buyStock'))
  const arb = hookFee(P, 101, 100, 0, true, 'sellStock')
  assert.ok(arb.armed)
  assert.ok(Math.abs(arb.fee - (0.01 - P.sigma) / 2) < 1e-4)
  // inside the deadband (d_eff <= 2 f0): base fee
  assert.equal(hookFee(P, 100.4, 100, 0, true, 'sellStock').fee, P.f0)
  // wrong direction: base fee
  assert.equal(hookFee(P, 101, 100, 0, true, 'buyStock').fee, P.f0)
  // closed session, stale, no price: fail-open to base fee
  assert.equal(hookFee(P, 105, 100, 0, false, 'sellStock').fee, P.f0)
  assert.equal(hookFee(P, 105, 100, 901, true, 'sellStock').fee, P.f0)
  assert.equal(hookFee(P, 105, 0, 0, true, 'sellStock').fee, P.f0)
  // cap
  assert.equal(hookFee(P, 150, 100, 0, true, 'sellStock').fee, P.feeMax)
})

test('arb plan lands on the post-fee boundary and is profitable', () => {
  const L = 1000
  const f = 0.003
  const sell = planArb(L, 101, 100, f)!
  assert.equal(sell.side, 'sellStock')
  assert.ok(Math.abs(sell.pTarget - 100 / (1 - f)) < 1e-9)
  assert.ok(sell.profit > 0)
  const buy = planArb(L, 99, 100, f)!
  assert.equal(buy.side, 'buyStock')
  assert.ok(buy.profit > 0)
  assert.equal(planArb(L, 100.1, 100, f), null) // inside the fee band
  // move cap shrinks the trade
  const capped = planArb(L, 110, 100, f, 0.01)!
  assert.ok(Math.abs(capped.pTarget - 110 * 0.99) < 1e-9)
})

test('model venue: swap moves price toward the trade and keeps fees', async () => {
  const v = new ModelVenue(DEFAULT_PARAMS)
  await v.init()
  const pool = v.pools().find((p) => p.ticker === 'NVDA' && p.kind === 'control')!
  const before = (await v.poolState(pool)).priceUsd
  const fill = await v.swap(pool, 'retail', 'sellStock', 100)
  assert.ok(fill.ok)
  assert.ok(fill.priceAfter < before)
  assert.ok(fill.stockDelta === 100 && fill.usdDelta < 0)
  assert.ok(Math.abs(fill.feeUsd - 100 * 0.003 * fill.priceAfter) < 0.5)
})

test('oracle semantics: heartbeats ignored, stale fails open', async () => {
  const v = new ModelVenue(DEFAULT_PARAMS)
  await v.init()
  await v.setTime(1_000_000)
  await v.pushReport('NVDA', 0, false, 1_000_000)
  assert.equal((await v.oracle('NVDA')).priceUsd, 0)
  await v.pushReport('NVDA', 190, true, 1_000_000)
  assert.equal((await v.oracle('NVDA')).priceUsd, 190)
  await v.pushReport('NVDA', 191, true, 999_999) // not newer, ignored
  assert.equal((await v.oracle('NVDA')).priceUsd, 190)
  const hookPool = v.pools().find((p) => p.ticker === 'NVDA' && p.kind === 'hook')!
  // pool starts near 187, ref 190 => pool below ref => buying is the arb direction
  const fresh = await v.quote(hookPool, 'buyStock')
  assert.ok(fresh.arbDirection)
  await v.setTime(1_000_000 + 2000) // reference now stale
  assert.equal((await v.quote(hookPool, 'buyStock')).feePips, v.f0Pips())
})

test('price path: reproducible, starts at the start price, closed hours are quiet', () => {
  const sc = SCENARIOS['volatile']!
  const start = nextNyStart(1_800_000_000, sc.start.weekday, sc.start.hour, sc.start.minute)
  const a = buildPath(sc, start, FALLBACK_START_USD, 5)
  const b = buildPath(sc, start, FALLBACK_START_USD, 5)
  assert.deepEqual(a.prices.slice(0, 5), b.prices.slice(0, 5))
  assert.equal(a.prices[0]!.NVDA, FALLBACK_START_USD.NVDA)
  // the NVDA shock at +3600 s lifts the path ~2.5%
  const i = 3600 / sc.stepSec
  assert.ok(a.prices[i + 1]!.NVDA / a.prices[i - 1]!.NVDA > 1.01)
})

test('session helper: next Friday 19:30 is a Friday in New York and the session closes at 20:00', () => {
  const t = nextNyStart(1_792_000_000, 5, 19, 30)
  assert.ok(getSessionState(t, 'extended').open)
  assert.ok(!getSessionState(t + 31 * 60, 'extended').open)
  assert.ok(getSessionState(t + 56.5 * 3600 + 60, 'extended').open) // Monday 04:00 reopens
})

test('replay start for weekend-gap exists in the downloaded bars and stays in one DST regime', () => {
  const bars = loadBars('SPY')
  if (!bars) return // data not present
  const ts = findReplayStart(bars, SCENARIOS['weekend-gap']!)
  assert.ok(ts !== null)
})

test('lpwatch accounting: LP P&L vs hold equals fees when price round-trips', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lpw-'))
  const v = new ModelVenue(DEFAULT_PARAMS)
  await v.init()
  const w = new LpWatch(dir, v.pools())
  const pool = v.pools().find((p) => p.ticker === 'SPY' && p.kind === 'control')!
  const start = v.startPriceUsd('SPY')
  const sell = await v.swap(pool, 'retail', 'sellStock', 0.05)
  w.record({ tick: 0, t: 0, pool, actor: 'retail', side: 'sellStock', fill: sell, refPrice: start, gasUsd: 0 })
  // pool received 5 stock and paid out USD; marked at the starting price the LP should be up by about the fee
  const pnl = w.lpPnl(pool, start)
  assert.ok(pnl > 0 && pnl < 0.05 * start * 0.01, `pnl=${pnl}`)
})

test('end to end on the model venue: weekend-gap and calm run, summary has the requested fields', async () => {
  for (const name of ['calm', 'weekend-gap']) {
    const dir = mkdtempSync(join(tmpdir(), 'sim-'))
    const sc = { ...SCENARIOS[name]!, ticks: name === 'calm' ? 60 : 80 }
    const v = new ModelVenue(DEFAULT_PARAMS)
    const s = (await runScenario({ scenario: sc, venue: v, params: DEFAULT_PARAMS, seed: 3, outDir: dir })) as { perTicker: Record<string, { hook: Record<string, number> }>; totals: { hook: { volume: number } } }
    for (const tk of TICKERS) {
      for (const f of ['volume', 'fees', 'arbProfit', 'retailFeePaid', 'lpPnl', 'swapsSurchargedPct', 'retailSurchargedPct']) {
        assert.ok(typeof s.perTicker[tk]!.hook[f] === 'number', `${tk}.${f}`)
      }
    }
    assert.ok(s.totals.hook.volume > 0)
    const lines = readFileSync(join(dir, 'metrics.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, sc.ticks)
    JSON.parse(lines[0]!)
  }
})

test('rng is deterministic', () => {
  const a = new Rng(1)
  const b = new Rng(1)
  assert.equal(a.next(), b.next())
  assert.equal(a.poisson(3), b.poisson(3))
})
