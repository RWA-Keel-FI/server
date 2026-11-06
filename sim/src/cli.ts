import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PARAMS, SCENARIOS, TICKERS, type Shock, type SimParams, type Ticker } from './config.ts'
import { runScenario } from './engine.ts'
import { ModelVenue } from './modelVenue.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string> } {
  const [cmd = 'help', ...rest] = argv
  const flags: Record<string, string> = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const next = rest[i + 1]
      if (next === undefined || next.startsWith('--')) flags[k] = 'true'
      else {
        flags[k] = next
        i++
      }
    }
  }
  return { cmd, flags }
}

const HELP = `usage: pnpm sim up --scenario calm|volatile|weekend-gap [options]

  --venue anvil|model   anvil = deployed v4 hook on a local anvil (default when deployments/local.json exists), model = in-memory
  --deployment <path>   path to deployments/local.json (default <project root>/deployments/local.json)
  --ticks N             override the scenario length
  --seed N              RNG seed (default 7)
  --shock T:PCT@HOURS   add a hidden news jump, e.g. NVDA:3@16 (+3% sixteen hours after the start); repeatable with commas
  --arb-chunks N        arb splits each full-boundary trade into N pieces (default 1)
  --tvl USD             model venue pool TVL (default 400000)
  --out <dir>           output directory (default sim/out)
`

function parseShocks(s: string | undefined): Shock[] {
  if (!s) return []
  return s.split(',').map((part) => {
    const m = /^([A-Z]+):(-?[\d.]+)@(-?[\d.]+)$/.exec(part.trim())
    if (!m) throw new Error(`bad --shock ${part}`)
    return { ticker: m[1] as Ticker, pct: Number(m[2]), atSec: Number(m[3]) * 3600 }
  })
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2))
  if (cmd !== 'up') {
    console.log(HELP)
    return
  }
  const sc0 = SCENARIOS[flags.scenario ?? 'calm']
  if (!sc0) throw new Error(`unknown scenario ${flags.scenario}`)
  const sc = { ...sc0, ticks: flags.ticks ? Number(flags.ticks) : sc0.ticks }
  const params: SimParams = { ...DEFAULT_PARAMS }
  if (flags['arb-chunks']) params.arbChunks = Number(flags['arb-chunks'])
  if (flags.tvl) params.modelTvlUsd = Number(flags.tvl)
  const seed = flags.seed ? Number(flags.seed) : 7
  const outDir = flags.out ?? join(root, 'out')
  const depPath = flags.deployment ?? join(root, '..', '..', 'deployments', 'local.json')
  const venueKind = flags.venue ?? (existsSync(depPath) ? 'anvil' : 'model')

  let venue
  if (venueKind === 'anvil') {
    if (!existsSync(depPath)) throw new Error(`no deployment file at ${depPath}; run the deploy step first or use --venue model`)
    const { AnvilVenue } = await import('./anvilVenue.ts')
    venue = new AnvilVenue(JSON.parse(readFileSync(depPath, 'utf8')), params, join(root, '..', '..', 'deployments'))
  } else {
    venue = new ModelVenue(params)
  }
  const summary = await runScenario({ scenario: sc, venue, params, seed, outDir, shocks: [...sc.shocks, ...parseShocks(flags.shock)], log: (s) => console.log(s) })
  const t = summary.totals as { hook: Record<string, number>; control: Record<string, number>; hookMinusControl: Record<string, number> }
  console.log('\n=== summary (all tickers) ===')
  console.log(`venue=${summary.venue}  priceMode=${summary.priceMode}`)
  console.log(`                 hook pools      control pools`)
  for (const k of ['volume', 'fees', 'arbProfit', 'retailFeePaid', 'retailAvgFeeBps', 'lpPnl', 'swapsSurchargedPct', 'retailSurchargedPct']) {
    console.log(`${k.padEnd(20)} ${String(t.hook[k]).padStart(12)} ${String(t.control[k]).padStart(14)}`)
  }
  console.log(`hook minus control: lpPnl=${t.hookMinusControl.lpPnl}  retailFeePaid=${t.hookMinusControl.retailFeePaid}  arbProfit=${t.hookMinusControl.arbProfit}`)
  console.log(`written: ${join(outDir, 'summary.json')} and metrics.jsonl`)
  void TICKERS
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
